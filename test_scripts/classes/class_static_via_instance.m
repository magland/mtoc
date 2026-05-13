% Static method called via an instance: `obj.staticMethod(args)`. The
% resolver detects the static-method-via-instance pattern (first arg
% is a ClassInstance, the method is in classStaticMethods) and sets
% stripInstance=true so mtoc drops the receiver before specializing.
classdef Counter
  properties
    val
  end
  methods
    function obj = Counter(v)
      obj.val = v;
    end
    function r = current(obj)
      r = obj.val;
    end
  end
  methods (Static)
    function r = combine(a, b)
      r = a + b * 100;
    end
  end
end

c = Counter(7);
disp(c.current());
% Instance-style static call: stripInstance drops `c` from the arg list.
disp(c.combine(3, 5));
% Also works as ClassName.method.
disp(Counter.combine(1, 2));
