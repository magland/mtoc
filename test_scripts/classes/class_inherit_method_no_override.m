% Child inherits a method from a parent without overriding it.
% Both dot-syntax and function-call-syntax dispatch the inherited
% method correctly via numbl's resolver.
classdef Parent
  properties
    val
  end
  methods
    function obj = Parent(v)
      obj.val = v;
    end
    function r = greet(obj)
      r = obj.val;
    end
  end
end

classdef Child < Parent
  properties
    tag
  end
  methods
    function obj = Child(v, t)
      obj.val = v;
      obj.tag = t;
    end
    function r = childOnly(obj)
      r = obj.tag;
    end
  end
end

c = Child(42, 7);
disp(c.greet());
disp(greet(c));
disp(c.childOnly());
disp(c.val);
disp(c.tag);
