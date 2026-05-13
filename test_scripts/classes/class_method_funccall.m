% Method called via function-call syntax `method(obj)`. The resolver
% routes through numbl's class-method-candidate scan; mtoc consumes
% the verdict and specializes.
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

d = Doubler(7);
y = apply(d, 6);
disp(y);
