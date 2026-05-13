% Method call via dot-syntax. The method reads a property and returns
% a derived scalar.
classdef Doubler
  properties
    factor
  end
  methods
    function obj = Doubler(f)
      obj.factor = f;
    end
    function r = apply(obj, x)
      r = obj.factor * x;
    end
  end
end

d = Doubler(3);
y = d.apply(5);
disp(y);
